import { Router } from 'express';
import authRouter from './auth/auth-router';

const globalRouter = Router();


globalRouter.use(authRouter);


export default globalRouter;
