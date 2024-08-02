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

const pageQueue = new Queue('pageQueueNedvizhkaDaily', { connection: redisConnection });
const apartmentQueue = new Queue('apartmentQueueNedvizhkaDaily', { connection: redisConnection });

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
        const descriptionElement = await detailPage.$('div.postDescription.is-size-6.mt-4');
        if (descriptionElement) {
            description = await detailPage.evaluate(el => el.innerText || '', descriptionElement);
            description = description.replace(/\n/g, ' ');
        }

        // console.log(description);

        const characteristics = await detailPage.$$eval('div.columns.is-marginless.is-multiline.mb-4.py-3 div.columns', divs => {
            const map = {};
            divs.forEach(div => {
                const keyElement = div.querySelector('p.is-size-7.mb-0.pb-0.has-text-grey-light');
                const valueElement = div.querySelector('span.is-size-6');
                if (keyElement && valueElement) {
                    const key = keyElement.textContent?.trim(); // Add null check
                    const value = valueElement.textContent?.trim(); // Add null check
                    if (key) {
                        map[key] = value;
                    }
                }
            });
            return map;
        });
        
        // console.log(characteristics);

        const price = await detailPage.$eval('span.is-size-4.has-text-weight-bold.has-text-black', el => {
            const priceText = el.textContent || '';
            const priceNumber = parseInt(priceText.replace(/\s|₸/g, ''), 10);
            return priceNumber;
        });

        // console.log(price);

        const floor = await detailPage.$eval(' h1.postTitle', el => {
            const text = el.textContent || '';
            const parts = text.split(',');
            return parts.slice(0, 3).join(',').trim();
        });
        // console.log(floor);

        let location = await detailPage.$eval(' h1.postTitle', el => {
            const text = el.textContent || '';
            const parts = text.split(',');
            return parts.slice(4).join(',').trim();
        });

        // console.log(location);

        const photos = await detailPage.$$eval('div.column.is-2 a.lslide', anchors => anchors.map(anchor => anchor.href));
        
        // console.log(photos);

        await detailPage.waitForSelector('button.is-info.is-fullwidth');
        await detailPage.click('button.is-info.is-fullwidth');
        await detailPage.waitForSelector('div.column.is-6 span.is-size-4.has-text-weight-bold');
        const number = await detailPage.$eval('div.column.is-6 span.is-size-4.has-text-weight-bold', el => el.textContent || '');
        // console.log(number);

        const mainCharacteristics: MainCharacteristics = { price, location, floor, number, photos };
        const site = "nedvizhka";  // Adding the site field
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
        await page.goto(pageUrl, { timeout: 60000});
        await autoScroll(page);

        const links = await page.$$eval('div.column.is-marginless.is-paddingless a[data-v-1886bbb4]:first-child', (anchors: HTMLAnchorElement[]) => anchors.map(anchor => anchor.href));
        for (const link of links) {
            await apartmentQueue.add('scrapeApartment', { link }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                }
            });
        }

        console.log(`Queued ${links.length} apartments from ${pageUrl} on nedvizhka daily almaty`);
    } catch (error) {
        console.error(`Error scraping page ${job.data.pageUrl}:`, error);
        await createBrowser();
        throw error;
    } finally {
        if (page) await page.close();
    }
}

async function nedvizhkaParseDailyAlmaty(): Promise<void> {
    try {
        await createBrowser(); 
        let currentPage = 1;
        let isLastPage = false;

        while (!isLastPage && currentPage <= Number(process.env.PARSER_PAGE_LIMIT)) {
            const pageUrl = `https://nedvizhka.kz/posts/kvartiry-arenda/almaty?page=${currentPage}&viewType=list&onlyComplexLayouts=0&personal=1&dict_rent_type_id=215`;
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
        console.error('Error in nedvizhkaParseDailyAlmaty:', error);
    } finally {
        const currentDate = new Date();
        const indexName = "homespark3";
        const index = pinecone.index(indexName);
        await deleteOlderThanDate(index, currentDate, "daily", "nedvizhka");
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
        apartmentWorker = new Worker('apartmentQueueNedvizhkaDaily', async job => {
            await scrapeApartment(job);
        }, { connection: redisConnection, concurrency: 1 });

        apartmentWorker.on('completed', job => console.log(`Apartment job ${job.id} completed`));
        apartmentWorker.on('failed', (job, err) => console.error(`Apartment job ${job?.id} failed with ${err}`));
    }
}


const pageWorker = new Worker('pageQueueNedvizhkaDaily', async job => {
    await scrapePage(job);
}, { connection: redisConnection, concurrency: 1 });

// Handle worker events
pageWorker.on('completed', job => console.log(`Page job ${job.id} completed`));
pageWorker.on('failed', (job, err) => console.error(`Page job ${job?.id} failed with ${err}`));


export default nedvizhkaParseDailyAlmaty;