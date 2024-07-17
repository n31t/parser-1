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

const pageQueue = new Queue('pageQueue', { connection: redisConnection });
const apartmentQueue = new Queue('apartmentQueue', { connection: redisConnection });

async function scrapeApartment(job: Job<{ link: string, browser: Browser }>): Promise<void> {
    const { link, browser } = job.data;
    let detailPage: Page | null = null;
    try {
        detailPage = await browser.newPage();
        const userAgent = getRandomUserAgent();
        if(!detailPage) {
            throw new Error('Failed to open a new page');
        }
        await detailPage.setUserAgent(userAgent);
        await detailPage.goto(link);

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
        console.error(`Error scraping link ${link}:`, error);
        throw error; // This will cause the job to be retried
    } finally {
        if (detailPage) await detailPage.close();
    }
}

async function scrapePage(job: Job<{ pageUrl: string, browser: Browser }>): Promise<void> {
    const { pageUrl, browser } = job.data;
    let page: Page | null = null;
    try {
        page = await browser.newPage();
        if(!page) {
            throw new Error('Failed to open a new page');
        }
        await page.goto(pageUrl);
        await autoScroll(page);

        const links = await page.$$eval('a.templates-object-card__body.yQfYt', anchors => anchors.map(anchor => anchor.href));

        for (const link of links) {
            await apartmentQueue.add('scrapeApartment', { link, browser }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                }
            });
        }

        console.log(`Queued ${links.length} apartments from ${pageUrl}`);
    } catch (error) {
        console.error(`Error scraping page ${pageUrl}:`, error);
        throw error; // This will cause the job to be retried
    } finally {
        if (page) await page.close();
    }
}

async function etagiParseBuyAlmaty(): Promise<void> {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

    try {
        let currentPage = 1;
        let isLastPage = false;

        while (!isLastPage && currentPage <= Number(process.env.PARSER_PAGE_LIMIT)) {
            const pageUrl = `https://almaty.etagi.com/realty/?page=${currentPage}`;
            await pageQueue.add('scrapePage', { pageUrl, browser }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                }
            });

            currentPage++;
            await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 5000)));
        }

        // Wait for all jobs to complete
        await pageQueue.drain();
        await apartmentQueue.drain();

    } catch (error) {
        console.error('Error in etagiParseBuyAlmaty:', error);
    } finally {
        await browser.close();

        const currentDate = new Date();
        const indexName = "homespark3";
        const index = pinecone.index(indexName);
        await deleteOlderThanDate(index, currentDate, "buy", "etagi");
    }
}

// Set up workers
const pageWorker = new Worker('pageQueue', async job => {
    await scrapePage(job);
}, { connection: redisConnection, concurrency: 1 });

const apartmentWorker = new Worker('apartmentQueue', async job => {
    await scrapeApartment(job);
}, { connection: redisConnection, concurrency: 1 });

// Handle worker events
pageWorker.on('completed', job => console.log(`Page job ${job.id} completed`));
pageWorker.on('failed', (job, err) => console.error(`Page job ${job?.id} failed with ${err}`));

apartmentWorker.on('completed', job => console.log(`Apartment job ${job.id} completed`));
apartmentWorker.on('failed', (job, err) => console.error(`Apartment job ${job?.id} failed with ${err}`));

export default etagiParseBuyAlmaty;