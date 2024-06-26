import mongoose from 'mongoose';

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/lecture1');
        console.log('MongoDB connected...');
    } catch (err:any) {
        console.error(err.message);
        process.exit(1);
    }
};

const ItemSchema = new mongoose.Schema({
    title: String,
    price: String,
    locationAndDate: Date,
    condition: String
});

const Item = mongoose.model('Item', ItemSchema);

async function saveData(data) {
    for (const item of data) {
        const newItem = new Item(item);
        await newItem.save();
    }
}

export default connectDB;
export { saveData };