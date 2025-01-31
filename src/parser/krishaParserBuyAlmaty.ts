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

                // If the operation is successful, break the loop
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
        }])
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
                    site: "krisha",
                },
                {
                    type: "buy",
                },
            ],
        },
    });
    await cleanUpOldPineconeEntries(index, currentDate, "buy", "krisha");
}

async function scrapeCurrentPage(page: Page, data: Data[]): Promise<void> {
    await autoScroll(page);
    const links = await page.$$eval('a.a-card__title', anchors => anchors.map(anchor => anchor.href));

    for (const link of links) {
        let detailPage: any; // Assuming detailPage is of any type. Replace with actual type.
        try {
            console.log(`Scraping link: ${link}`);
            const detailPage = await page.browser().newPage();
            const userAgent = getRandomUserAgent();
            await detailPage.setUserAgent(userAgent);
            await detailPage.goto(link);

            await detailPage.waitForSelector('div.offer__sidebar');
            
            let description = '';
            const descriptionElement = await detailPage.$('div.js-description.a-text.a-text-white-spaces');
    
            if (descriptionElement) {
                description = await detailPage.$eval('div.js-description.a-text.a-text-white-spaces', el => el.textContent || '');
                description = description.replace(/\n/g, ' ');
                // console.log(description);
            } else {
                description = "Нет описания"
                // console.log(description);
            }

            const characteristics = await detailPage.$$eval('div.offer__parameters dl', items => {
                const itemData: { [key: string]: string } = {};
                if (items.length > 0) {
                    items.forEach(item => {
                        const key = item.querySelector('dt')?.textContent;
                        const value = item.querySelector('dd')?.textContent;
                        if (key && value) {
                            itemData[key] = value;
                        }
                    });
                }
                return itemData;
            });
            // console.log(characteristics);

            // const price = await detailPage.$eval('div.offer__price', el => {
            //     const priceText = el.textContent || '';
            //     const priceNumber = parseInt(priceText.replace(/\s|₸/g, ''), 10);
            //     return priceNumber;
            // });
            let price = 0;
            let priceElement = await detailPage.$('div.offer__price');
            if (priceElement) {
                price = await detailPage.$eval('div.offer__price', el => {
                    const priceText = el.textContent || '';
                    const priceNumber = parseInt(priceText.replace(/\s|₸/g, ''), 10);
                    return priceNumber;
                });
            }
            else{
                price = await detailPage.$eval(' p.offer__price', el => {
                    const priceText = el.textContent || '';
                    const priceNumber = parseInt(priceText.replace(/[^0-9]/g, ''), 10);
                    return priceNumber;
            });
            }
            // console.log(price)

            const floor = await detailPage.$eval('div.offer__advert-title h1', el => {
                let floorText = el.textContent || '';
                floorText = floorText.trim(); // Remove leading and trailing spaces
                const splitText = floorText.split('этаж');
                if (splitText.length > 1) {
                    floorText = `${splitText[0]}этаж`; // Include 'этаж' in the result
                }
                return floorText;
            });
            // console.log(floor)

            const location = await detailPage.$eval('div.offer__advert-title h1', el => {
                let text = el.textContent || '';
                text = text.trim(); // Remove leading and trailing spaces

                const splitText = text.split('этаж');
                let floorText = '';
                if (splitText.length > 1) {
                    floorText = `${splitText[0]}этаж`; // Include 'этаж' in the result
                }

                const locationText = text.split(', ').pop() || ''; // Get the part after the last comma

                return locationText;
            });

            // console.log(location)

            const photos = await detailPage.$$eval('div.gallery__small-item', elements => 
                elements.map(el => el.getAttribute('data-photo-url') || ''));
            // console.log(photos);

            await detailPage.waitForSelector('button.show-phones');
            await detailPage.click('button.show-phones');

            let number = '';
            try{
                await detailPage.waitForSelector('div.offer__contacts-phones p');
                number = (await detailPage.$eval('div.offer__contacts-phones p', el => el.textContent || '' )).trim();
            }
            catch (error) {
                const isPhoneNumberHidden = await detailPage.$('div.a-phones__hidden span.phone') !== null;
                if (isPhoneNumberHidden) {
                    const phoneNumber = await detailPage.$eval('div.a-phones__hidden span.phone', el => el.textContent || '');
                    if (phoneNumber.includes('*')) {
                        number = "+7 *** *** ****";
                }
            }}
            // console.log(number)

            const mainCharacteristics: MainCharacteristics = { price, location, floor, number, photos };
            const site = "krisha";  // Adding the site field
            const type = "buy";   // Adding the type field
            data.push({ link, characteristics, mainCharacteristics, description, site, type });
            // console.log(`Extracted data: ${JSON.stringify({ link, characteristics, mainCharacteristics }, null, 2)}`);
            await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 5000))); // Random delay between 40 to 80 seconds
        } catch (error) {
            console.error(`Error scraping link ${link}:`, error);
            await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 5000))); // Random delay between 40 to 80 seconds
        } finally {
            if (detailPage) {
                await detailPage.close();
            }
        }
    }
}

async function scrapeAllPages(page: Page, data: Data[], currentPage: number = 1): Promise<void> {
    let isLastPage = false;
    
    while (!isLastPage) {
        console.log(`Scraping page ${currentPage}...`);
        try {
            await page.goto(`https://krisha.kz/prodazha/kvartiry/almaty/?das[_sys.hasphoto]=1&das[who]=1&page=${currentPage}`);
            isLastPage = await page.$('a.a-card__title') === null;
            if (!isLastPage && currentPage<Number(process.env.PARSER_PAGE_LIMIT)) {
                await scrapeCurrentPage(page, data);
                await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 5000))); // Random delay between 2 to 5 seconds
                currentPage++;
            } else {
                isLastPage = true;
                console.log("Last page reached");
            }
        } catch (error) {
            console.error(`Error scraping page ${currentPage}:`, error);
            // Continue to next page if an error occurs
            await page.browser().close();
            const newBrowser = await puppeteer.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });
            const newPage = await newBrowser.newPage();
            page = newPage; 
            currentPage++;
            if (currentPage > 1200) {
                return;
            }
        }
    }
}

async function krishaParseBuyAlmaty(): Promise<Data[]> {
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

// krishaParseBuyAlmaty()

export default krishaParseBuyAlmaty;
