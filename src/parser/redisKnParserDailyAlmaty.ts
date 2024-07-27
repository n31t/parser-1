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

const pageQueue = new Queue('pageQueueKnDaily', { connection: redisConnection });
const apartmentQueue = new Queue('apartmentQueueKnDaily', { connection: redisConnection });

let browser: Browser | null = null;

async function createBrowser() {
    if (browser) {
        await browser.close();
    }
    browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
}

async function scrapeApartment(job: Job<{ link: string }>): Promise<void> {
    let detailPage: Page | null = null;
    try {
        if (!browser) {
            await createBrowser();
        }
        const { link } = job.data;
        detailPage = await browser!.newPage();
        await detailPage.goto(link);
        
        const userAgent = getRandomUserAgent();
        await detailPage.setUserAgent(userAgent);

        let description = '';
        const descriptionElement = await detailPage.$('p.description-text');
        if (descriptionElement) {
            description = await detailPage.evaluate(el => el.textContent || '', descriptionElement);
            description = description.replace(/\n/g, ' ');
        }

        // console.log(description);

        const characteristics = await detailPage.$$eval('table tbody tr', rows => {
            const rowData = {};
            rows.forEach(row => {
                const keyElement = row.querySelector('th');
                const valueElement = row.querySelector('td');
                if (keyElement && valueElement) {
                    const key = keyElement.textContent?.trim(); // Add null check
                    const value = valueElement.textContent?.trim(); // Add null check
                    if (key) {
                        rowData[key] = value;
                    }
                }
            });
            return rowData;
        });
        
        // console.log(characteristics);

        const price = await detailPage.$eval('span.price', el => {
            const priceText = el.textContent || '';
            const priceNumber = parseInt(priceText.replace(/\s|₸/g, ''), 10);
            return priceNumber;
        });

        // console.log(price);

        const floor = await detailPage.$eval('div.col-content.title h1', el => {
            const text = el.textContent || '';
            const parts = text.split(',');
            return parts.slice(0, 2).join(',').trim();
        });
        // console.log(floor);
        let location = await detailPage.$eval('div.address', el => {
            let locationText = '';
            for (let i = 0; i < el.childNodes.length; i++) {
                if (el.childNodes[i].nodeType === Node.TEXT_NODE) {
                    locationText += el.childNodes[i].textContent;
                }
            }
            return locationText.trim();
        });

        const street = await detailPage.$eval('div.col-content.title h1', el => {
            const text = el.textContent || '';
            const parts = text.split(',');
            return parts[3] ? parts[3].trim() : '';
        }); 

        location = location + ', ' + street;
        // console.log(location);

        const photos = await detailPage.$$eval('div.image-preview-list a[rel="object-image"]', elements => {
            return elements.map(el => 'https://www.kn.kz' + el.getAttribute('href'));
        });
        
        // console.log(photos);

        const number = await detailPage.$eval('span.js-all-phones-view.block-all-phones-view span.con-pers__phone', el => el.textContent || '');
        console.log(number);

        const mainCharacteristics: MainCharacteristics = { price, location, floor, number, photos };
        const site = "kn";  // Adding the site field
        const type = "daily";   // Adding the type field

        const apartmentData: Data = { link, characteristics, mainCharacteristics, description, site, type };
        // console.log(apartmentData);
        // data.push(apartmentData);
        await saveToDatabase(apartmentData);

        

        console.log(`Scraped and saved apartment: ${link}`);
    } catch (error) {
        console.error(`Error scraping link ${job.data.link}:`, error);
        await createBrowser();
        throw error; // This will cause the job to be retried
    } finally {
        if (detailPage) await detailPage.close();
    }
}

async function scrapePage(job: Job<{ pageUrl: string }>): Promise<void> {
    let page: Page | null = null;
    try {
        if (!browser) {
            await createBrowser();
        }
        const { pageUrl } = job.data;
        page = await browser!.newPage();
        await page.goto(pageUrl);
        await autoScroll(page);

        const links = await page.$$eval('a.results-item-street', anchors => anchors.map(anchor => anchor.href));

        for (const link of links) {
            await apartmentQueue.add('scrapeApartment', { link }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                }
            });
        }

        console.log(`Queued ${links.length} apartments from ${pageUrl} on kn daily almaty`);
    } catch (error) {
        console.error(`Error scraping page ${job.data.pageUrl}:`, error);
        await createBrowser();
        throw error;
    } finally {
        if (page) await page.close();
    }
}

async function knParseDailyAlmaty(): Promise<void> {
    try {
        await createBrowser(); 
        let currentPage = 1;
        let isLastPage = false;

        while (!isLastPage && currentPage <= 10) {
            const pageUrl = `https://www.kn.kz/almaty/arenda-kvartir-posutochno/page/${currentPage}/`;
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

        // Wait for all page jobs to complete
        await waitForQueueCompletion(pageQueue);

        // Start apartment worker
        startApartmentWorker();

        // Wait for all apartment jobs to complete
        await waitForQueueCompletion(apartmentQueue);

    } catch (error) {
        console.error('Error in knParseDailyAlmaty:', error);
    } finally {
        const currentDate = new Date();
        const indexName = "homespark3";
        const index = pinecone.index(indexName);
        await deleteOlderThanDate(index, currentDate, "daily", "kn");
        await browser!.close();
    }

}

async function waitForQueueCompletion(queue: Queue): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const checkQueue = async () => {
            const jobCounts = await queue.getJobCounts();
            if (jobCounts.waiting === 0 && jobCounts.active === 0) {
                resolve();
            } else {
                setTimeout(checkQueue, 2000); // Check again after 2 seconds
            }
        };
        checkQueue().catch(reject);
    });
}

let apartmentWorker: Worker | null = null;

function startApartmentWorker() {
    if (!apartmentWorker) {
        apartmentWorker = new Worker('apartmentQueueKnDaily', async job => {
            await scrapeApartment(job);
        }, { connection: redisConnection, concurrency: 1 });

        apartmentWorker.on('completed', job => console.log(`Apartment job ${job.id} completed`));
        apartmentWorker.on('failed', (job, err) => console.error(`Apartment job ${job?.id} failed with ${err}`));
    }
}


const pageWorker = new Worker('pageQueueKnDaily', async job => {
    await scrapePage(job);
}, { connection: redisConnection, concurrency: 1 });

// Handle worker events
pageWorker.on('completed', job => console.log(`Page job ${job.id} completed`));
pageWorker.on('failed', (job, err) => console.error(`Page job ${job?.id} failed with ${err}`));


export default knParseDailyAlmaty;