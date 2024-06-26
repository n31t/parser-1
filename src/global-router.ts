import { Router } from 'express';
import authRouter from './auth/auth-router';
import olxProductsRouter from './olxProducts/olxProducts-router';

const globalRouter = Router();


globalRouter.use(authRouter);
globalRouter.use(olxProductsRouter)


export default globalRouter;
