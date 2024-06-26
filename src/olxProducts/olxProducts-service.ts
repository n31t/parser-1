import OlxProduct from "../auth/models/OlxProduct";

class OlxProductService {
    async create(productData) {
        const product = new OlxProduct(productData);
        await product.save();
        return product;
    }

    async read(id) {
        const product = await OlxProduct.findById(id);
        return product;
    }

    async getAll() {
        const products = await OlxProduct.find();
        return products;
    }

    async update(id, updateData) {
        const product = await OlxProduct.findByIdAndUpdate(id, updateData, { new: true });
        return product;
    }

    async delete(id) {
        const product = await OlxProduct.findByIdAndDelete(id);
        return product;
    }
}

export default OlxProductService;