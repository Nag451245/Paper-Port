import { PrismaClient, type User } from '@prisma/client';
type RiskAppetite = string;
export interface RegisterInput {
    email: string;
    password: string;
    fullName: string;
    riskAppetite?: RiskAppetite;
    virtualCapital?: number;
}
export interface LoginInput {
    email: string;
    password: string;
}
export interface BreezeCredentialInput {
    apiKey: string;
    secretKey: string;
    totpSecret?: string;
    sessionToken?: string;
    loginId?: string;
    loginPassword?: string;
}
export interface UserProfile {
    id: string;
    email: string;
    fullName: string;
    riskAppetite: string;
    virtualCapital: number;
    role: string;
    isActive: boolean;
    createdAt: Date;
}
export declare class AuthService {
    private prisma;
    private jwtSecret;
    private readonly encKey;
    constructor(prisma: PrismaClient, jwtSecret: string);
    register(input: RegisterInput): Promise<{
        user: UserProfile;
        userId: string;
    }>;
    private loginAttempts;
    private readonly MAX_LOGIN_ATTEMPTS;
    private readonly LOCKOUT_DURATION_MS;
    private checkLockout;
    private recordFailedAttempt;
    private clearFailedAttempts;
    login(input: LoginInput): Promise<{
        user: UserProfile;
        userId: string;
    }>;
    getProfile(userId: string): Promise<UserProfile>;
    updateProfile(userId: string, data: Partial<Pick<User, 'fullName' | 'riskAppetite' | 'virtualCapital'>>): Promise<UserProfile>;
    saveBreezeCredentials(userId: string, input: BreezeCredentialInput): Promise<{
        configured: boolean;
        updatedAt: Date;
    }>;
    saveSessionToken(userId: string, apiSession: string): Promise<{
        success: boolean;
    }>;
    getBreezeCredentialStatus(userId: string): Promise<{
        configured: boolean;
        hasTotp: boolean;
        hasSession: boolean;
        hasLoginCredentials: boolean;
        canAutoLogin: boolean;
        sessionExpiry: string | null;
        lastAutoLoginAt: string | null;
        autoLoginError: string | null;
        updatedAt: string | null;
    }>;
    deleteBreezeCredentials(userId: string): Promise<void>;
    getDecryptedBreezeCredentials(userId: string): Promise<{
        apiKey: string;
        secretKey: string;
        sessionToken: string | null;
    } | null>;
    createBreezeLoginUrl(userId: string, state?: string): Promise<{
        loginUrl: string;
        callbackUrl: string;
    }>;
    autoGenerateSession(userId: string): Promise<{
        success: boolean;
        sessionExpiry: string;
        method: string;
    }>;
    renewExpiringSessions(): Promise<{
        attempted: number;
        refreshed: number;
        errors: string[];
    }>;
    private generateTotpCode;
    /**
     * Wait for the current TOTP window to be fresh (at least 5s remaining)
     * to avoid submitting a code that expires mid-request.
     */
    private waitForFreshTotp;
    /**
     * Strategy 1: Full browser-flow simulation.
     * Replicates what happens when a user logs in via the ICICI Breeze login page:
     *  1. GET login page → extract form fields, cookies, form action
     *  2. POST credentials → get TOTP/2FA page
     *  3. POST TOTP → follow redirect to get apisession
     *  4. Exchange apisession via CustomerDetails API
     */
    private browserFlowLogin;
    /**
     * Strategy 2: Direct POST to /apiuser/tradelogin (works for some accounts).
     */
    private directTradeLogin;
    private extractSessionFromText;
    private extractCookies;
    private mergeCookies;
    private extractFormAction;
    private extractHiddenFields;
}
export declare class AuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number);
}
export {};
//# sourceMappingURL=auth.service.d.ts.map