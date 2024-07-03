import 'dotenv/config';
import express from 'express';
import globalRouter from './global-router';
import { logger } from './logger';
import krishaParseRentAlmaty from './parser/krishaParserRentAlmaty';
// import parseData from './parser/etagiParserRentAlmaty';
import scheduleScraper from './parser/etagiParserBuyAlmaty';
import cron from 'node-cron';
import etagiParseBuyAlmaty from './parser/etagiParserBuyAlmaty';
import etagiParseRentAlmaty from './parser/etagiParserRentAlmaty';
import krishaParseBuyAlmaty from './parser/krishaParserBuyAlmaty';
import krishaParseDailyAlmaty from './parser/krishaParserDailyAlmaty';


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
      await Promise.all([
          // etagiParseBuyAlmaty().then(() => {
          //     console.log('Finished scraping for buy.');
          // }),
          // etagiParseRentAlmaty().then(() => {
          //     console.log('Finished scraping for rent.');
          // }),
          // krishaParseBuyAlmaty().then(() => {
          //     console.log('Finished scraping for buy.');
          // }),
          krishaParseRentAlmaty().then(() => {
              console.log('Finished scraping for rent.');
          }),
          // krishaParseDailyAlmaty().then(() => {
          //     console.log('Finished scraping for daily.');
          // }),
      ]);
      console.log('All scraping tasks completed.');
  } catch (error) {
      console.error('Error during scraping process:', error);
  }
}

function scheduleScrapers() {
  runScrapers();

  cron.schedule('0 0 * * *', runScrapers);
}

scheduleScrapers();

// saveDataToDB();
// setInterval(saveDataToDB, 30 * 60 * 1000);
