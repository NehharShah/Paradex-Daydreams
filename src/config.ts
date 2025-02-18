import { z } from "zod";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const envSchema = z.object({
    PARADEX_ACCOUNT_ADDRESS: z.string().min(1),
    PARADEX_PRIVATE_KEY: z.string().min(1),
    PARADEX_BASE_URL: z.string().min(1),
    PARADEX_CHAIN_ID: z.string().min(1),
    // ANTHROPIC_API_KEY: z.string().min(1),
    // GROQ_API_KEY: z.string().min(1),
    // OPENAI_API_KEY: z.string().min(1),
});

type EnvConfig = z.infer<typeof envSchema>;

function loadEnvConfig(): EnvConfig {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.join(dirname, "..");
    const envFile = ".env";
    const envPath = path.resolve(projectRoot, envFile);
    console.debug(`Loading config from ${envPath}`);

    dotenv.config({ path: envPath });

    // Validate environment variables against the schema
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        console.error(
            "❌ Invalid environment variables:",
            result.error.format(),
        );
        throw new Error("Invalid environment variables");
    }

    return result.data;
}

export const env = loadEnvConfig();
