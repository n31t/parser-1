import puppeteer, { Page, Browser } from "puppeteer";
import { Characteristics, Data, MainCharacteristics } from "./types/apartments";
import { autoScroll, deleteOlderThanDate, getRandomDelay, getRandomUserAgent, saveToDatabase } from "./utils/utils";
import { Queue, Worker, Job } from "bullmq";
import Redis from "ioredis";
// import redisConnection from "../redis";

let { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
import pinecone from "../pinecone";

const redisUrl = process.env.REDIS_URL || 'redis://';
console.log(`Connecting to Redis at ${redisUrl}`);
const redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 10000,
});

const pageQueue = new Queue('pageQueueKrishaBuy', { connection: redisConnection });
const apartmentQueue = new Queue('apartmentQueueKrishaBuy', { connection: redisConnection });

async function scrapeApartmentWithTimeout(job: Job<{ link: string }>): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Scraping timed out for link: ${job.data.link}`));
        }, 120000); // 2 minutes timeout

        scrapeApartment(job)
            .then(resolve)
            .catch(reject)
            .finally(() => clearTimeout(timeout));
    });
}

async function scrapeApartment(job: Job<{ link: string }>): Promise<void> {
    let browser: Browser | null = null;
    let detailPage: Page | null = null;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const { link } = job.data;
        detailPage = await browser.newPage();
        const userAgent = getRandomUserAgent();
        await detailPage.setUserAgent(userAgent);
        
        // Remove the default navigation timeout
        await detailPage.setDefaultNavigationTimeout(0);
        
        // Navigate to the page and wait for network to be idle
        await detailPage.goto(link, { waitUntil: 'networkidle0' });

        // Wait for specific elements that indicate the content has loaded
        await detailPage.waitForSelector('div.offer__sidebar', { timeout: 60000 });
        await detailPage.waitForSelector('div.offer__parameters', { timeout: 60000 });


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

        const apartmentData: Data = { link, characteristics, mainCharacteristics, description, site, type };
        await saveToDatabase(apartmentData);

        console.log(`Scraped and saved apartment: ${link}`);
    } catch (error) {
        console.error(`Error scraping link ${job.data.link}:`, error);
        throw error; // This will cause the job to be retried
    } finally {
        if (detailPage) await detailPage.close();
        if (browser) await browser.close();
    }
}

async function scrapePage(job: Job<{ pageUrl: string }>): Promise<void> {
    let browser: Browser | null = null;
    let page: Page | null = null;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const { pageUrl } = job.data;
        page = await browser.newPage();
        await page.goto(pageUrl);
        await autoScroll(page);

        const links = await page.$$eval('a.a-card__title', anchors => anchors.map(anchor => anchor.href));

        for (const link of links) {
            await apartmentQueue.add('scrapeApartment', { link }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                }
            });
        }

        console.log(`Queued ${links.length} apartments from ${pageUrl} on krisha buy almaty page`);
    } catch (error) {
        console.error(`Error scraping page ${job.data.pageUrl}:`, error);
        throw error;
    } finally {
        if (page) await page.close();
        if (browser) await browser.close();
    }
}

async function krishaParseBuyAlmaty(): Promise<void> {
    try {
        let currentPage = 1;
        let isLastPage = false;

        while (!isLastPage && currentPage <= Number(process.env.PARSER_PAGE_LIMIT)) {
            const pageUrl = `https://krisha.kz/prodazha/kvartiry/almaty/?das[_sys.hasphoto]=1&das[who]=1&page=${currentPage}`;
            await pageQueue.add('scrapePage', { pageUrl }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                }
            });

            currentPage++;
            await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 3000)));
        }

        await new Promise<void>((resolve, reject) => {
            const checkQueues = async () => {
                const [pageCount, apartmentCount] = await Promise.all([
                    pageQueue.getJobCounts(),
                    apartmentQueue.getJobCounts()
                ]);

                if (pageCount.waiting === 0 && pageCount.active === 0 &&
                    apartmentCount.waiting === 0 && apartmentCount.active === 0) {
                    resolve();
                } else {
                    setTimeout(checkQueues, 2000); // Check again after 2 seconds
                }
            };

            checkQueues().catch(reject);
        });

    } catch (error) {
        console.error('Error in krishaParseBuyAlmaty:', error);
    } finally {
        const currentDate = new Date();
        const indexName = "homespark3";
        const index = pinecone.index(indexName);
        await deleteOlderThanDate(index, currentDate, "buy", "krisha");
    }

}

// Set up workers
const pageWorker = new Worker('pageQueueKrishaBuy', async job => {
    await scrapePage(job);
}, { connection: redisConnection, concurrency: 1 });

const apartmentWorker = new Worker('apartmentQueueKrishaBuy', async job => {
    await scrapeApartmentWithTimeout(job);
}, { connection: redisConnection, concurrency: 1 });

// Handle worker events
pageWorker.on('completed', job => console.log(`Page job ${job.id} completed`));
pageWorker.on('failed', (job, err) => console.error(`Page job ${job?.id} failed with ${err}`));

apartmentWorker.on('completed', job => console.log(`Apartment job ${job.id} completed`));
apartmentWorker.on('failed', (job, err) => console.error(`Apartment job ${job?.id} failed with ${err}`));

export default krishaParseBuyAlmaty;