import puppeteer, { Page } from "puppeteer";
import { Characteristics, Data, MainCharacteristics } from "./types/apartments";
import { PrismaClient } from "@prisma/client";
import { autoScroll, getRandomDelay, getRandomUserAgent } from "./utils/utils";

import cron from 'node-cron';
//COPY PINECONE CODE
let { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
import pinecone from "../pinecone";
const prisma = new PrismaClient();

async function cleanUpOldPineconeEntries(index, currentDate) {
    const deleteOlderThanDate = new Date(currentDate);
    deleteOlderThanDate.setDate(deleteOlderThanDate.getDate() - 1);
    const embeddedPrompt = await new GoogleGenerativeAIEmbeddings().embedQuery('delete old vectors from Pinecone.');
        
        
        let results = await index.query({
            vector: embeddedPrompt,
            topK: 10000, // Retrieve more vectors initially
            filter: {
                type: "buy",
                site: "etagi",
            },
            includeMetadata: true,
        });
        const allIds = results.matches.map((match) => match.id);
        let idsToDelete: string[] = [];
        
        for (const id of allIds) {
            const vector = await index.fetch([id]);
            const metadata = vector.records[id]?.metadata;
            if (metadata && metadata.site === "etagi" && metadata.type === "buy" && new Date(metadata.lastChecked).getTime() < deleteOlderThanDate.getTime()) {
                idsToDelete.push(id);
            }
        }
        
        if (idsToDelete.length > 0) {
            await index.deleteMany(idsToDelete);
            console.log(`Deleted ${idsToDelete.length} old vectors from Pinecone.`);
        } else {
            console.log("No old vectors found to delete.");
        }
}
//COPY PINECONE CODE
async function saveToDatabase(data: Data[]): Promise<void> {
    const currentDate = new Date();
    //COPY PINECONE CODE
    const embeddings = new GoogleGenerativeAIEmbeddings({
        model: "embedding-001", // 768 dimensions
    });

    const indexName = "homespark2";
    const index = pinecone.index(indexName);
    //COPY PINECONE CODE

    for (const { link, characteristics, mainCharacteristics, description,site, type } of data) {
        const { price, location, floor, number, photos } = mainCharacteristics;
        await prisma.apartment.upsert({
            where: { link },
            update: { price, location, floor, number, photos, characteristics, description, lastChecked: currentDate, site, type },
            create: { link, price, location, floor, number, photos, characteristics, description, lastChecked: currentDate, site, type },
        });

        //COPY PINECONE CODE
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
        }])
    }
    
    await prisma.apartment.deleteMany({
        where: {
            AND: [
                {
                    lastChecked: {
                        lt: currentDate,
                    },
                },
                {
                    site: "etagi",
                },
                {
                    type: "buy",
                },
            ],
        },
    });
    //COPY PINECONE CODE
    await cleanUpOldPineconeEntries(index, currentDate);
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

            // await detailPage.click('button.plr_dNP.plr_yks.plr_gY6.plr_l4J');
            const buttons = await detailPage.$$('button.cuZ5z.Ave0A.jJShB.tOs6D._0LC_o.GmYmq.zPhuj');
            if(buttons.length > 1){
                await buttons[1].click();
                await buttons[0].click();
            }
            else{
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
            const type = "buy";   // Adding the type field

            data.push({ link, characteristics, mainCharacteristics, description, site, type });
            // console.log(`Extracted data: ${JSON.stringify({ link, characteristics, mainCharacteristics }, null, 2)}`);
        } catch (error) {
            console.error(`Error scraping link ${link}:`, error);
        }finally {
            await detailPage.close();
        }
    }
}

async function scrapeAllPages(page: Page, data: Data[], currentPage: number = 1): Promise<void> {
    let isLastPage = false;
    
    while (!isLastPage) {
        console.log(`Scraping page ${currentPage}...`);
        try {
            await page.goto(`https://almaty.etagi.com/realty/?page=${currentPage}`);
            isLastPage = await page.$eval('div.ZJ0dK', div => div.textContent === 'Ничего не найдено').catch(() => false);
            if (!isLastPage && currentPage<50) {
                await scrapeCurrentPage(page, data);

                const nextPageExists = await page.$('button.jJShB.Y5bqE._jBUx.GmYmq.zPhuj') !== null;

                if (nextPageExists) {
                    await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 5000))); // Random delay between 2 to 5 seconds
                    currentPage++;
                } else {
                    isLastPage = true;
                    console.log("Last page reached");
                }
            } else {
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

async function etagiParseBuyAlmaty(): Promise<Data[]> {
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


export default etagiParseBuyAlmaty;
