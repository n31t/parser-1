import puppeteer, { Page } from "puppeteer";
import { Characteristics, Data, MainCharacteristics } from "./types/apartments";
import { autoScroll, cleanUpOldPineconeEntries, deleteOlderThanDate, getRandomDelay, getRandomUserAgent, saveToDatabase } from "./utils/utils";

import cron from 'node-cron';

let { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
import pinecone from "../pinecone";

async function scrapeCurrentPage(page: Page): Promise<void> {
    // await autoScroll(page);
    const links = await page.$$eval('div.column.is-marginless.is-paddingless a[data-v-1886bbb4]:first-child', (anchors: HTMLAnchorElement[]) => anchors.map(anchor => anchor.href));
    const data: Data[] = [];
    
    for (const link of links) {
        let detailPage: any; // Assuming detailPage is of any type. Replace with actual type.
        try {
            console.log(`Scraping link: ${link}`);
            detailPage = await page.browser().newPage();
            const userAgent = getRandomUserAgent();
            await detailPage.setUserAgent(userAgent);
            await detailPage.goto(link);

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
                        const key = keyElement.textContent.trim();
                        const value = valueElement.textContent.trim();
                        map[key] = value;
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

            // const mainCharacteristics: MainCharacteristics = { price, location, floor, number, photos };
            const site = "nedvizhka";  // Adding the site field
            const type = "daily";   // Adding the type field

            // const apartmentData: Data = { link, characteristics, mainCharacteristics, description, site, type };
            // console.log(apartmentData);
            // data.push(apartmentData);
            // await saveToDatabase(apartmentData);

        } catch (error) {
            console.error(`Error scraping link ${link}:`, error);
        } finally {
            await detailPage.close();
        }
    }
}

async function scrapeAllPages(page: Page, currentPage: number = 1): Promise<void> {
    let isLastPage = false;

    while (!isLastPage) {
        console.log(`Scraping page ${currentPage}...`);
        try {
            await page.goto(`https://nedvizhka.kz/posts/kvartiry-arenda/almaty?page=${currentPage}&viewType=list&onlyComplexLayouts=0&personal=1&dict_rent_type_id=215`, {timeout: 60000});
            
            if ((currentPage <= 5)) {
                await scrapeCurrentPage(page);
                await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 5000))); // Random delay between 2 to 5 seconds
                currentPage++;
            } else {
                isLastPage = true;
                console.log("Last page reached");
            }
        } catch (error) {
            console.error(`Error scraping page ${currentPage}:`, error);
            // Close the current browser instance and create a new one
            await page.browser().close();
            const newBrowser = await puppeteer.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });
            const newPage = await newBrowser.newPage();
            page = newPage; 
            currentPage++;
            if (currentPage > 100) {
                return;
            }
        }
    }
}

async function nedvizhkaParseDailyAlmaty(): Promise<void> {
    const browser = await puppeteer.launch({
        // headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    const page = await browser.newPage( );

    try {
        await scrapeAllPages(page);
    } catch (error) {
        console.error('Error in scrapeAllPages:', error);
    } finally {
        await browser.close();
    }

    const currentDate = new Date();
    const indexName = "homespark3";
    const index = pinecone.index(indexName);
    await deleteOlderThanDate(index, currentDate, "daily", "nedvizhka");

}


export default nedvizhkaParseDailyAlmaty;
