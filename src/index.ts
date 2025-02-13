import { shortString } from "starknet";
import type { Account, SystemConfig } from "./types";
import { authenticate } from "./paradex";
import { env } from "./config";

async function main() {
    const apiBaseUrl = env.PARADEX_BASE_URL;
    const chainId = shortString.encodeShortString(env.PARADEX_CHAIN_ID);

    // mainnet, see https://api.prod.paradex.trade/v1/system/config
    // const apiBaseUrl = "https://api.prod.paradex.trade/v1"
    // const chainId = shortString.encodeShortString("PRIVATE_SN_PARACLEAR_MAINNET");

    const config: SystemConfig = {
        apiBaseUrl,
        starknet: { chainId },
    };

    const account: Account = {
        address: process.env.PARADEX_ACCOUNT_ADDRESS || "",
        privateKey: process.env.PARADEX_PRIVATE_KEY || "",
    };

    console.log(`Authenticating account ${account.address}`);
    account.jwtToken = await authenticate(config, account);
    console.log(`JWT token: ${account.jwtToken}`);
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
