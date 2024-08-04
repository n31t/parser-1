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

const pageQueue = new Queue('pageQueueNedvizhimostproRent', { connection: redisConnection });
const apartmentQueue = new Queue('apartmentQueueNedvizhimostproRent', { connection: redisConnection });

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
        const descriptionElement = await detailPage.$('div.descHid');
        if (descriptionElement) {
            description = await detailPage.evaluate(el => el.innerText || '', descriptionElement);
            description = description.replace(/\n/g, ' ');
        }

        // Select all li elements within div.fullInf
        const fullInfElements = await detailPage.$$eval('div.application_statics.mt30 li', (elements: HTMLLIElement[]) => 
            elements.map(el => el.innerText.trim())
        );

        // Convert the text content to hashtags
        const hashtags = fullInfElements.map(text => `${text}`).join(', ');

        // Append the hashtags to the description
        description += ' ' + hashtags;

        console.log(description);

        const characteristics = await detailPage.$$eval('div.col-md-6.col-lg-6.mob-pl-pr-5', divs => {
            const map: Record<string, string> = {};
            divs.forEach(div => {
                const keys = Array.from(div.querySelectorAll('ul.list-inline-item:nth-child(1) p'))
                    .map(p => (p as HTMLElement).textContent?.trim() || '');
                const values = Array.from(div.querySelectorAll('ul.list-inline-item:nth-child(2) p span'))
                    .map(span => (span as HTMLElement).textContent?.trim() || '');
                keys.forEach((key, i) => {
                    if (key) {
                        map[key] = values[i];
                    }
                });
            });
            return map;
        });
        
        console.log(characteristics);
        

        const price = await detailPage.$eval('div.price h2', el => {
            const priceText = el.textContent || '';
            const priceNumber = parseInt(priceText.replace(/\s|₸/g, ''), 10);
            return priceNumber;
        });

        console.log(price);

        const floor = await detailPage.$eval('div.single_property_title.mt30-767 h2', el => {
            const text = el.textContent || '';
            return text
        });
        console.log(floor);

        let location = '';
        try{
        location = await detailPage.$eval('div.single_property_title.mt30-767 p', el => {
            const text = el.textContent || '';
            return text
        });

        console.log(location);
        }
        catch(e){
            console.log("Location not found");
            throw e;
        }

        const photos = await detailPage.$$eval('div.owl-item a', (anchors: HTMLAnchorElement[]) => 
            [...new Set(anchors.map(anchor => anchor.href))]
        );
        
        console.log(photos);
        
        const number = await detailPage.$eval('p.mb0', el => {
            const text = el.textContent || '';
            return text
        })
        console.log(number);

        const mainCharacteristics: MainCharacteristics = { price, location, floor, number, photos };
        const site = "nedvizhimostpro";  // Adding the site field
        const type = "rent";   // Adding the type field

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

        console.log(`Queued ${links.length} apartments from ${pageUrl} on nedvizhimostpro rent almaty`);
    } catch (error) {
        console.error(`Error scraping page ${job.data.pageUrl}:`, error);
        await createBrowser();
        throw error;
    } finally {
        if (page) await page.close();
    }
}

async function nedvizhimostproParseRentAlmaty(): Promise<void> {
    try {
        await createBrowser(); 
        let currentPage = 1;
        let isLastPage = false;

        while (!isLastPage && currentPage <= Number(process.env.PARSER_PAGE_LIMIT)) {
            const pageUrl = `https://nedvizhimostpro.kz/quicksearch/main/mainsearch?sort=date_created&objType=1&city%5B0%5D=2&rooms=0&apType=3&price_Min=&price_Max=&square=&floor=0&page=${currentPage}`;
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
        console.error('Error in nedvizhimostproParseRentAlmaty:', error);
    } finally {
        const currentDate = new Date();
        const indexName = "homespark3";
        const index = pinecone.index(indexName);
        await deleteOlderThanDate(index, currentDate, "rent", "nedvizhimostpro");
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
        apartmentWorker = new Worker('apartmentQueueNedvizhimostproRent', async job => {
            await scrapeApartment(job);
        }, { connection: redisConnection, concurrency: 1 });

        apartmentWorker.on('completed', job => console.log(`Apartment job ${job.id} completed`));
        apartmentWorker.on('failed', (job, err) => console.error(`Apartment job ${job?.id} failed with ${err}`));
    }
}


const pageWorker = new Worker('pageQueueNedvizhimostproRent', async job => {
    await scrapePage(job);
}, { connection: redisConnection, concurrency: 1 });

// Handle worker events
pageWorker.on('completed', job => console.log(`Page job ${job.id} completed`));
pageWorker.on('failed', (job, err) => console.error(`Page job ${job?.id} failed with ${err}`));


export default nedvizhimostproParseRentAlmaty;