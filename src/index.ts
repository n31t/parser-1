import 'dotenv/config';
import express from 'express';
import connectDB from './db';
import globalRouter from './global-router';
import { logger } from './logger';
import saveDataToDB from './parser/axiosParser';
import parseData from './parser/etagiParser2';

const app = express();
const PORT = process.env.PORT || 3939;
// connectDB();
app.use(logger);
app.use(express.json());
app.use('/api/v1/',globalRouter);


app.get('/helloworld',(request,response) =>{
  response.send("Hello World!");
})

app.get('/parser',(request,response) =>{
  parseData();
  response.send("Data parsed!");
})

app.listen(PORT, () => {
  console.log(`Server runs at http://localhost:${PORT}`);
});




// saveDataToDB();
// setInterval(saveDataToDB, 30 * 60 * 1000);
