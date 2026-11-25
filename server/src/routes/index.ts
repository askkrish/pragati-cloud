import type { FastifyInstance } from 'fastify';
import type { Runner, Services } from '../app.ts';
import { authRoutes } from './auth.ts';
import { communityRoutes } from './community.ts';
import { propertyRoutes } from './property.ts';
import { peopleRoutes } from './people.ts';
import { committeeRoutes } from './committees.ts';
import { approvalRoutes } from './approvals.ts';
import { recordRoutes } from './records.ts';
import { operationsRoutes } from './operations.ts';
import { workRoutes } from './work.ts';
import { assetRoutes } from './assets.ts';
import { procurementRoutes } from './procurement.ts';
import { financeRoutes } from './finance.ts';
import { financeReportRoutes } from './finance-reports.ts';
import { noticeRoutes } from './notices.ts';

export async function registerRoutes(app: FastifyInstance, run: Runner, svc: Services) {
  for (const r of [authRoutes, communityRoutes, propertyRoutes, peopleRoutes, committeeRoutes, approvalRoutes, recordRoutes,
    operationsRoutes, workRoutes, assetRoutes, procurementRoutes, financeRoutes, financeReportRoutes, noticeRoutes]) {
    await r(app, run, svc);
  }
}
