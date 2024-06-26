import { Router } from "express";
import OlxProductService from "./olxProducts-service";
import OlxProductsController from "./olxProducts-controller";

const olxProductsRouter = Router();

const olxProductsService = new OlxProductService;
const olxProductsController = new OlxProductsController(olxProductsService);

olxProductsRouter.post('/', olxProductsController.createProduct);
olxProductsRouter.get('/', olxProductsController.getProducts);
olxProductsRouter.get('/:id', olxProductsController.getProductById);
olxProductsRouter.put('/:id', olxProductsController.updateProduct);
olxProductsRouter.delete('/:id', olxProductsController.deleteProduct);

export default olxProductsRouter;


