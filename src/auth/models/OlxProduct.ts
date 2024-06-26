import mongoose, { Schema } from "mongoose";

export interface IOlxProduct extends mongoose.Document {
    title: string;
    price: string;
    locationAndDate: Date;
    condition: string;
}

const OlxProductSchema : Schema = new Schema({
    title: { type: String, required: true },
    price: { type: String, required: true },
    locationAndDate: { type: Date, required: true },
    parsedDate: { type: Date, required: true },
    condition: { type: String, required: true }
});

export default mongoose.model<IOlxProduct>('OlxProduct', OlxProductSchema);


