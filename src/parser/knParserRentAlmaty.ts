import puppeteer, { Page } from "puppeteer";
import { Characteristics, Data, MainCharacteristics } from "./types/apartments";
import { autoScroll, cleanUpOldPineconeEntries, deleteOlderThanDate, getRandomDelay, getRandomUserAgent, saveToDatabase } from "./utils/utils";

import cron from 'node-cron';

let { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
import pinecone from "../pinecone";

async function scrapeCurrentPage(page: Page): Promise<void> {
    await autoScroll(page);
    const links = await page.$$eval('a.results-item-street', anchors => anchors.map(anchor => anchor.href));
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
                        const key = keyElement.textContent.trim();
                        const value = valueElement.textContent.trim();
                        rowData[key] = value;
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
            const type = "rent";   // Adding the type field

            const apartmentData: Data = { link, characteristics, mainCharacteristics, description, site, type };
            console.log(apartmentData);
            // data.push(apartmentData);
            // await saveToDatabase(apartmentData);

        } catch (error) {
            console.error(`Error scraping link ${link}:`, error);
        } finally {
            await detailPage.close();
        }
    }
}

async function scrapeAllPages(page: Page, currentPage: number = 4): Promise<void> {
    let isLastPage = false;

    while (!isLastPage) {
        console.log(`Scraping page ${currentPage}...`);
        try {
            await page.goto(`https://www.kn.kz/almaty/arenda-kvartir/page/${currentPage}/`);
            
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

async function knParseRentAlmaty(): Promise<void> {
    const browser = await puppeteer.launch({
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
    await deleteOlderThanDate(index, currentDate, "rent", "kn");

}


export default knParseRentAlmaty;
