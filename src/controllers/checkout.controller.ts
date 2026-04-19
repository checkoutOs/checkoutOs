import { Request, Response } from 'express';
import { getCheckoutData } from '../services/checkout.service';
import { renderCheckoutPage, renderSuccessPage, renderFailurePage } from '../views/checkout.view';
import { asyncHandler } from '../utils/asyncHandler';

type Params<T> = T;

export const checkoutPage = asyncHandler<Params<{ chkId: string }>>(
  async (req: Request<{ chkId: string }>, res: Response): Promise<Response> => {
    const { chkId } = req.params;

    const data = await getCheckoutData(chkId);

    if (data.status === 'SUCCESS') {
      return res.send(renderSuccessPage(data));
    }

    if (data.status === 'FAILED') {
      return res.send(renderFailurePage(data));
    }

    const html = renderCheckoutPage(data);

    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  },
);

export const checkoutSuccess = asyncHandler(
  async (req: Request, res: Response): Promise<Response> => {
    const chkId = req.query.chkId as string;

    if (!chkId) {
      return res.status(400).send('Missing chkId');
    }

    const data = await getCheckoutData(chkId);

    return res.send(renderSuccessPage(data));
  },
);
