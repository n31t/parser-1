import puppeteer, { Page } from "puppeteer";
import { Characteristics, Data, MainCharacteristics } from "./types/apartments";
import { autoScroll, cleanUpOldPineconeEntries, deleteOlderThanDate, getRandomDelay, getRandomUserAgent, saveToDatabase } from "./utils/utils";

import cron from 'node-cron';

let { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
import pinecone from "../pinecone";

async function scrapeCurrentPage(page: Page): Promise<void> {
    await autoScroll(page);
    const links = await page.$$eval('a.templates-object-card__body.yQfYt', anchors => anchors.map(anchor => anchor.href));
    const data: Data[] = [];
    
    for (const link of links) {
        let detailPage: any; // Assuming detailPage is of any type. Replace with actual type.
        try {
            console.log(`Scraping link: ${link}`);
            detailPage = await page.browser().newPage();
            const userAgent = getRandomUserAgent();
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
            data.push(apartmentData);
            await saveToDatabase(apartmentData);

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
            await page.goto(`https://almaty.etagi.com/realty/?page=${currentPage}`);
            isLastPage = await page.$eval('div.ZJ0dK', div => div.textContent === 'Ничего не найдено').catch(() => false);
            
            if (!isLastPage && (currentPage < Number(process.env.PARSER_PAGE_LIMIT))) {
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
            if (currentPage > 500) {
                return;
            }
        }
    }
}

async function etagiParseBuyAlmaty(): Promise<void> {
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
    await deleteOlderThanDate(index, currentDate, "buy", "etagi");

}


export default etagiParseBuyAlmaty;
