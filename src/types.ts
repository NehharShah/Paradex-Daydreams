export interface Account {
    address: string;
    // publicKey: string;
    //ethereumAccount: string;
    privateKey: string;
    jwtToken?: string;
}

export interface SystemConfig {
    readonly apiBaseUrl: string;
    readonly starknet: {
        readonly chainId: string;
    };
}
