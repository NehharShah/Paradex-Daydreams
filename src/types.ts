export interface ParadexAccount {
    address: string;
    // publicKey: string;
    //ethereumAccount: string;
    privateKey: string;
    jwtToken?: string;
}

export interface ParadexConfig {
    readonly apiBaseUrl: string;
    readonly starknet: {
        readonly chainId: string;
    };
}