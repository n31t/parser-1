const axios = require('axios');
const cheerio = require('cheerio');
const chrono = require('chrono-node');
const mongoose = require('mongoose');

const url = 'https://almaty.etagi.com/realty_rent/';

async function fetchData() {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    const data = $('div.css-1venxj6').map((i, element) => {
        const title = $(element).find('h6.css-16v5mdi').text();
        const price = $(element).find('p.css-tyui9s').text();
        const locationAndDate = $(element).find('p.css-1a4brun').text();
        const parsedDate = chrono.parseDate(locationAndDate);
        const condition = $(element).find('span.css-3lkihg').text();

        return { title, price, locationAndDate: parsedDate, condition };
    }).get();

    return data;
}

async function saveDataToDB() {
    const data = await fetchData();
    await mongoose.connect(process.env.MONGODB_URL || 'mongodb+srv://mongo:mongopassword@cluster0.sp1fmqq.mongodb.net/');
    const ItemSchema = new mongoose.Schema({
        title: String,
        price: String,
        locationAndDate: Date,
        condition: String
    });
    console.log('Connected to MongoDB');
    const Item = mongoose.model('Item', ItemSchema);

    for (const item of data) {
        const newItem = new Item(item);
        await newItem.save();
    }
}

// Run saveDataToDB every 30 minutes
saveDataToDB();
setInterval(saveDataToDB, 30 * 60 * 1000);

export default saveDataToDB;