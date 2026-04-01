import type { PrismaClient } from '@prisma/client';
export interface UniverseCriteria {
    minAvgVolume?: number;
    maxSpreadBps?: number;
    sectors?: string[];
    excludeSectors?: string[];
    momentumFilter?: 'TOP_N' | 'BOTTOM_N';
    momentumN?: number;
    exchange?: string;
}
export interface UniverseEntry {
    symbol: string;
    exchange: string;
    sector?: string;
    avgVolume: number;
    spreadBps: number;
    relativeStrength: number;
    reason: string;
}
export declare class UniverseSelectorService {
    private prisma;
    constructor(prisma: PrismaClient);
    select(criteria: UniverseCriteria): Promise<UniverseEntry[]>;
    refreshUniverse(userId: string, criteria: UniverseCriteria): Promise<UniverseEntry[]>;
    getUserUniverse(userId: string): Promise<UniverseEntry[]>;
}
//# sourceMappingURL=universe-selector.service.d.ts.map