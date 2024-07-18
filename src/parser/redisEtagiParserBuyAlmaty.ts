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

const pageQueue = new Queue('pageQueueEtagiBuy', { connection: redisConnection });
const apartmentQueue = new Queue('apartmentQueueEtagiBuy', { connection: redisConnection });

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

        const buttons = await detailPage.$$('button.cuZ5z.Ave0A.jJShB.tOs6D._0LC_o.GmYmq.zPhuj');
        if (buttons.length > 1) {
            await buttons[1].click();
            await buttons[0].click();
        } else if (buttons.length > 0) {
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

        await detailPage.waitForSelector('span[data-testid="object_current_price"]');
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

        const apartmentData: Data = { link, characteristics, mainCharacteristics, description, site, type };
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

        const links = await page.$$eval('a.templates-object-card__body.yQfYt', anchors => anchors.map(anchor => anchor.href));

        for (const link of links) {
            await apartmentQueue.add('scrapeApartment', { link }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                }
            });
        }

        console.log(`Queued ${links.length} apartments from ${pageUrl} on etagi buy almaty page`);
    } catch (error) {
        console.error(`Error scraping page ${job.data.pageUrl}:`, error);
        await createBrowser(); 
        throw error;
    } finally {
        if (page) await page.close();
    }
}

async function etagiParseBuyAlmaty(): Promise<void> {
    try {
        await createBrowser(); 
        let currentPage = 1;
        let isLastPage = false;

        while (!isLastPage && currentPage <= Number(process.env.PARSER_PAGE_LIMIT)) {
            const pageUrl = `https://almaty.etagi.com/realty/?page=${currentPage}`;
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
        console.error('Error in etagiParseBuyAlmaty:', error);
    } finally {
        const currentDate = new Date();
        const indexName = "homespark3";
        const index = pinecone.index(indexName);
        await deleteOlderThanDate(index, currentDate, "buy", "etagi");
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
        apartmentWorker = new Worker('apartmentQueueEtagiBuy', async job => {
            await scrapeApartment(job);
        }, { connection: redisConnection, concurrency: 1 });

        apartmentWorker.on('completed', job => console.log(`Apartment job ${job.id} completed`));
        apartmentWorker.on('failed', (job, err) => console.error(`Apartment job ${job?.id} failed with ${err}`));
    }
}


const pageWorker = new Worker('pageQueueEtagiBuy', async job => {
    await scrapePage(job);
}, { connection: redisConnection, concurrency: 1 });

// Handle worker events
pageWorker.on('completed', job => console.log(`Page job ${job.id} completed`));
pageWorker.on('failed', (job, err) => console.error(`Page job ${job?.id} failed with ${err}`));

export default etagiParseBuyAlmaty;