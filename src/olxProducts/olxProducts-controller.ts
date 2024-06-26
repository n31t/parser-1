import { Request, Response } from 'express';
import OlxProductsService from './olxProducts-service';
import { IOlxProduct } from '../auth/models/OlxProduct';

class OlxProductsController {
  private olxProductsService: OlxProductsService;

  constructor(olxProductsService: OlxProductsService) {
    this.olxProductsService = olxProductsService;
  }

  createProduct = async (req: Request, res: Response): Promise<void> => {
    try {
      const product: IOlxProduct = req.body;
      const newProduct = await this.olxProductsService.create(product);
      res.status(201).json(newProduct);
    } catch (error: any) {
      res.status(500).send({ error: error.message });
    }
  }

  getProducts = async (req: Request, res: Response): Promise<void> => {
    try {
      const products = await this.olxProductsService.getAll();
      res.status(200).json(products);
    } catch (error: any) {
      res.status(500).send({ error: error.message });
    }
  }

  getProductById = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const product = await this.olxProductsService.read(id);
      if (!product) {
        res.status(404).json({ message: 'Product not found' });
        return;
      }
      res.status(200).json(product);
    } catch (error: any) {
      res.status(500).send({ error: error.message });
    }
  }

  updateProduct = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const productUpdate: Partial<IOlxProduct> = req.body;
      const product = await this.olxProductsService.update(id, productUpdate);
      if (!product) {
        res.status(404).json({ message: 'Product not found' });
        return;
      }
      res.status(200).json(product);
    } catch (error: any) {
      res.status(500).send({ error: error.message });
    }
  }

  deleteProduct = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      await this.olxProductsService.delete(id);
      res.status(204).send();
    } catch (error: any) {
      res.status(500).send({ error: error.message });
    }
  }
}

export default OlxProductsController;