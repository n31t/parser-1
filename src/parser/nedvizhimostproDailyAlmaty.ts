import puppeteer, { Page } from "puppeteer";
import { Characteristics, Data, MainCharacteristics } from "./types/apartments";
import { autoScroll, cleanUpOldPineconeEntries, deleteOlderThanDate, getRandomDelay, getRandomUserAgent, saveToDatabase } from "./utils/utils";

import cron from 'node-cron';

let { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
import pinecone from "../pinecone";

async function scrapeCurrentPage(page: Page): Promise<void> {
    // await autoScroll(page);
    const links = await page.$$eval('div.feat_property.list div.thumb a', (anchors: HTMLAnchorElement[]) => 
        anchors.map(anchor => anchor.href).filter(href => href !== 'javascript:void(0)')
    );    
    const data: Data[] = [];
    
    for (const link of links) {
        let detailPage: any; // Assuming detailPage is of any type. Replace with actual type.
        try {
            console.log(`Scraping link: ${link}`);
            detailPage = await page.browser().newPage();
            const userAgent = getRandomUserAgent();
            await detailPage.setUserAgent(userAgent);
            await detailPage.goto(link);

            // const showLink = await detailPage.$('div.showLink a');
            // if (showLink) {
            //     await showLink.click();
            // }

            // const showLink2 = await detailPage.$('div.showLink2 a');
            // if (showLink2) {
            //     await showLink2.click();
            // }

            // let description = '';
            // const descriptionElement = await detailPage.$('div.descHid');
            // if (descriptionElement) {
            //     description = await detailPage.evaluate(el => el.innerText || '', descriptionElement);
            //     description = description.replace(/\n/g, ' ');
            // }

            // console.log(description);
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
                continue;
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
            await page.goto(`https://nedvizhimostpro.kz/quicksearch/main/mainsearch?sort=date_created&objType=1&city%5B0%5D=2&rooms=0&apType=3&price_Min=&price_Max=&square=&floor=0&page=${currentPage}`, {timeout: 60000});
            
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

async function nedvizhimostproParseDailyAlmaty(): Promise<void> {
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
    await deleteOlderThanDate(index, currentDate, "daily", "nedvizhimostpro");

}


export default nedvizhimostproParseDailyAlmaty;
