import { TradeReportingService } from '../services/trade-reporting.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
export default async function reportRoutes(app) {
    const reportingService = new TradeReportingService(getPrisma());
    app.get('/contract-note/:orderId', { preHandler: [authenticate] }, async (request, reply) => {
        try {
            const { orderId } = request.params;
            const userId = getUserId(request);
            const prisma = getPrisma();
            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { portfolio: true },
            });
            if (!order) {
                return reply.code(404).send({ error: 'Order not found' });
            }
            if (order.portfolio.userId !== userId) {
                return reply.code(403).send({ error: 'Forbidden' });
            }
            const note = await reportingService.generateContractNote(orderId);
            return reply.send(note);
        }
        catch (err) {
            request.log.error(err, 'contract note generation failed');
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });
    app.get('/daily/:date', { preHandler: [authenticate] }, async (request, reply) => {
        try {
            const { date } = request.params;
            const userId = getUserId(request);
            const parsed = new Date(date);
            if (isNaN(parsed.getTime())) {
                return reply.code(400).send({ error: 'Invalid date format' });
            }
            const summary = await reportingService.generateDailySummary(userId, parsed);
            return reply.send(summary);
        }
        catch (err) {
            request.log.error(err, 'daily summary generation failed');
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });
    app.get('/pnl-statement', { preHandler: [authenticate] }, async (request, reply) => {
        try {
            const { from, to } = request.query;
            const userId = getUserId(request);
            if (!from || !to) {
                return reply.code(400).send({ error: 'Query params "from" and "to" are required' });
            }
            const fromDate = new Date(from);
            const toDate = new Date(to);
            if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
                return reply.code(400).send({ error: 'Invalid date format for "from" or "to"' });
            }
            const statement = await reportingService.generatePnLStatement(userId, fromDate, toDate);
            return reply.send(statement);
        }
        catch (err) {
            request.log.error(err, 'P&L statement generation failed');
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });
    app.get('/tax-summary', { preHandler: [authenticate] }, async (request, reply) => {
        try {
            const { fy } = request.query;
            const userId = getUserId(request);
            if (!fy) {
                return reply.code(400).send({ error: 'Query param "fy" is required (e.g. 2025-26)' });
            }
            const summary = await reportingService.generateTaxSummary(userId, fy);
            return reply.send(summary);
        }
        catch (err) {
            request.log.error(err, 'tax summary generation failed');
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });
}
//# sourceMappingURL=reports.js.map