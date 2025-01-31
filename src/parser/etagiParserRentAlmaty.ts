import puppeteer, { Page } from "puppeteer";
import { Characteristics, Data, MainCharacteristics } from "./types/apartments";
import { PrismaClient } from "@prisma/client";
import { autoScroll, cleanUpOldPineconeEntries, getRandomDelay, getRandomUserAgent } from "./utils/utils";
import cron from 'node-cron';

let { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
import pinecone from "../pinecone";
const prisma = new PrismaClient();

async function saveToDatabase(data: Data[]): Promise<void> {
    const currentDate = new Date();

    const embeddings = new GoogleGenerativeAIEmbeddings({
        model: "embedding-001", // 768 dimensions
    });

    const indexName = "homespark3";
    const index = pinecone.index(indexName);

    const maxRetries = 5;
    const delay = 5000; 
    for (const { link, characteristics, mainCharacteristics, description, site, type } of data) {
        const { price, location, floor, number, photos } = mainCharacteristics;

        for (let i = 0; i < maxRetries; i++) {
            try {
                await prisma.apartment.upsert({
                    where: { link },
                    update: { price, location, floor, number, photos, characteristics,description, lastChecked: currentDate, site, type },
                    create: { link, price, location, floor, number, photos, characteristics, description, lastChecked: currentDate, site, type },
                });

                break;
            } catch (error) {
                console.error(`Attempt ${i + 1} to save data failed. Retrying in ${delay / 1000} seconds...`, error);

                // If this was the last attempt, rethrow the error
                if (i === maxRetries - 1) {
                    throw error;
                }

                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        // Prepare text for embedding
        const text = `${description} 
        ${price} 
        ${location} 
        ${floor} 
        ${characteristics}`;
        
        // Generate embedding for Pinecone
        const embedding = await embeddings.embedDocuments([text]);
        console.log("length of embeddings: " + embedding.length);

        const flattenedEmbedding = embedding.flat();

        //Upsert data to Pinecone
        await index.upsert([{
            id: link,
            values: flattenedEmbedding,
            metadata: {
                link,
                price,
                location,
                floor,
                characteristics: Object.entries(characteristics).map(([key, value]) => `${key}: ${value}`),
                description,
                site,
                type,
                lastChecked: currentDate.toString()
            }
        }]);
        
    }

    const deleteOlderThanDate = new Date(currentDate);
    deleteOlderThanDate.setDate(deleteOlderThanDate.getDate() - 1);
    await prisma.apartment.deleteMany({
        where: {
            AND: [
                {
                    lastChecked: {
                        lt: deleteOlderThanDate,
                    },
                },
                {
                    site: "etagi",
                },
                {
                    type: "rent",
                },
            ],
        },
    });
    await cleanUpOldPineconeEntries(index, currentDate, "rent", "etagi");
}

async function scrapeCurrentPage(page: Page, data: Data[]): Promise<void> {
    await autoScroll(page);
    const links = await page.$$eval('a.templates-object-card__body.yQfYt', anchors => anchors.map(anchor => anchor.href));

    for (const link of links) {
        let detailPage: any; // Assuming detailPage is of any type. Replace with actual type.
        try {
            console.log(`Scraping link: ${link}`);

            detailPage = await page.browser().newPage();
            const userAgent = getRandomUserAgent();
            await detailPage.setUserAgent(userAgent);
            await detailPage.goto(link);

            await detailPage.waitForSelector('div[data-testid="object_characteristics"]');
            
            const buttons = await detailPage.$$('button.cuZ5z.Ave0A.jJShB.tOs6D._0LC_o.GmYmq.zPhuj');
            if(buttons.length > 0){
                await buttons[0].click();
            }

            let description = '';
            const descriptionElement = await detailPage.$('div.tv2WS');
            if (descriptionElement) {
                description = await detailPage.evaluate(el => el.textContent || '', descriptionElement);
                description = description.replace(/\n/g, ' ');
            }

            const characteristics = await detailPage.$$eval('div[data-testid="object_characteristics"] li.gWNDI', items => {
                const itemData: Characteristics = {};
                items.forEach(item => {
                    const key = item.querySelector('span.Y65Dj')?.textContent;
                    const value = item.querySelector('span.XVztD')?.textContent;
                    if (key && value) {
                        itemData[key] = value;
                    }
                });
                return itemData;
            });

            const price = await detailPage.$eval('span[data-testid="object_current_price"]', el => {
                const priceText = el.textContent || '';
                const priceNumber = parseInt(priceText.replace(/\s|₸/g, ''), 10);
                return priceNumber;
            });
            const floor = await detailPage.$eval('span[data-testid="object_title"]', el => el.textContent || '');
            const location = await detailPage.$eval('div[data-testid="object_address"]', el => {
                const clone = el.cloneNode(true) as HTMLElement;
                const unwantedDiv = clone.querySelector('.NU4YX');
                if (unwantedDiv) unwantedDiv.remove();
                return clone.textContent || '';
            });

            const photos = await detailPage.$$eval('div.msUAD.MAfDE', elements => {
                return elements.map(el => {
                    const style = getComputedStyle(el);
                    const backgroundImage = style.backgroundImage;
                    const match = backgroundImage.match(/url\("(.*)"\)/);
                    return match ? match[1] : '';
                });
            });

            await detailPage.click('button.ertXu');

            await detailPage.waitForFunction(
                (buttonText) => {
                    const button = document.querySelector('button.ertXu span');
                    return button && button.textContent !== buttonText;
                },
                {},
                ''
            );

            const number = await detailPage.$eval('button.ertXu span', el => el.textContent || '');

            const mainCharacteristics: MainCharacteristics = { price, location, floor, number, photos };
            const site = "etagi";  // Adding the site field
            const type = "rent";   // Adding the type field

            data.push({ link, characteristics, mainCharacteristics,description, site, type });
            // console.log(`Extracted data: ${JSON.stringify({ link, characteristics, mainCharacteristics }, null, 2)}`);
        } catch (error) {
            console.error(`Error scraping link ${link}:`, error);
        } finally {
            await detailPage.close();
        }
    }
}

async function scrapeAllPages(page: Page, data: Data[], currentPage: number = 1): Promise<void> {
    let isLastPage = false;
    
    while (!isLastPage) {
        console.log(`Scraping page ${currentPage}...`);
        try {
            await page.goto(`https://almaty.etagi.com/realty_rent/?page=${currentPage}`);
            isLastPage = await page.$eval('div.ZJ0dK', div => div.textContent === 'Ничего не найдено').catch(() => false);
            if (!isLastPage && currentPage<Number(process.env.PARSER_PAGE_LIMIT)) {
                await scrapeCurrentPage(page, data);

                // const nextPageExists = await page.$('button.jJShB.Y5bqE._jBUx.GmYmq.zPhuj') !== null;

                // if (nextPageExists) {
                    await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 5000))); // Random delay between 2 to 5 seconds
                    currentPage++;
                // } else {
                //     isLastPage = true;
                //     console.log("Last page reached");
                // }
            } else {
                isLastPage = true;
                console.log("Last page reached");
            }
        } catch (error) {
            console.error(`Error scraping page ${currentPage}:`, error);
            // Continue to next page if an error occurs
            currentPage++;
            if (currentPage > 500) {
                return;
            }
        }
    }
}

async function etagiParserRentAlmaty(): Promise<Data[]> {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    const page = await browser.newPage();
    const data: Data[] = [];

    try {
        await scrapeAllPages(page, data);
        await saveToDatabase(data);
    } catch (error) {
        console.error('Error in scrapeAllPages:', error);
    } finally {
        await browser.close();
    }
    
    return data;
}

// function scheduleScraper() {
//     async function runScraper() {
//         try {
//             await parseData();
//             console.log('Scraping completed successfully');
//         } catch (error) {
//             console.error('Error during scraping process:', error);
//         }
//     }
//     runScraper();

//     // Schedule the scraper to run every 12 hours using node-cron
//     cron.schedule('0 */12 * * *', runScraper);
// }

// scheduleScraper();

export default etagiParserRentAlmaty;