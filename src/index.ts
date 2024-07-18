import 'dotenv/config';
import express from 'express';
import globalRouter from './global-router';
import { logger } from './logger';
// import parseData from './parser/etagiParserRentAlmaty';
import cron from 'node-cron';
// import etagiParseBuyAlmaty from './parser/etagiParserBuyAlmaty';
import etagiParseBuyAlmaty from './parser/redisEtagiParserBuyAlmaty';
// import etagiParseRentAlmaty from './parser/etagiParserRentAlmaty';
import etagiParseRentAlmaty from './parser/redisEtagiParserRentAlmaty';
// import krishaParseBuyAlmaty from './parser/krishaParserBuyAlmaty';
import krishaParseBuyAlmaty from './parser/redisKrishaParserBuyAlmaty';
// import krishaParseDailyAlmaty from './parser/krishaParserDailyAlmaty';
import krishaParseDailyAlmaty from './parser/redisKrishaParserDailyAlmaty';
// import krishaParseRentAlmaty from './parser/krishaParserRentAlmaty';
import krishaParseRentAlmaty from './parser/redisKrishaParserRentAlmaty';


const app = express();
const PORT = process.env.PORT || 3939;
// connectDB();
app.use(logger);
app.use(express.json());
app.use('/api/v1/',globalRouter);

app.get('/helloworld',(request,response) =>{
  response.send("Hello World!");
})

// app.get('/runschedule'), (request,response) => {
//   scheduleScraper();
//   response.send('Schedule is running');
// }


app.listen(PORT, () => {
  console.log(`Server runs at http://localhost:${PORT}`);
});

async function runScrapers() {
  try {
    console.log('Starting concurrent scraping...');

    // await Promise.all([
    //   etagiParseRentAlmaty().then(() => {
    //     console.log('Finished scraping for rent.');
    //   }),
    // ]);
    await Promise.all([
      etagiParseBuyAlmaty().then(() => {
        console.log('Finished scraping for buy.');
      }),
    ]);
    // await Promise.all([
    //   krishaParseDailyAlmaty().then(() => {
    //     console.log('Finished scraping for buy.');
    //   }),
    // ]);

    // await Promise.all([
    //   krishaParseBuyAlmaty().then(() => {
    //     console.log('Finished scraping for buy.');
    //   }),
    // ]);

    // await Promise.all([
    //   krishaParseRentAlmaty().then(() => {
    //     console.log('Finished scraping for buy.');
    //   }),
    // ]);

    console.log('All scraping tasks completed.');
  } catch (error) {
    console.error('Error during scraping process:', error);
  }
}
function scheduleScrapers() {
  runScrapers();

  cron.schedule('0 0 */2 * *', runScrapers);
}

scheduleScrapers();
// runScrapers();

// saveDataToDB();
// setInterval(saveDataToDB, 30 * 60 * 1000);
