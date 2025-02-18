# paradreams

Proof-of-concept of a [Daydreams](https://www.dreams.fun/) powered trading agent connected to [Paradex](https://www.paradex.trade/).

## Usage

* Clone the repo and install dependencies via `bun install`.
* Copy the `.env.example` file to `.env` and set the environment variables.
* If you want to run on Paradex mainnet, update the code in `paradexLogin` in `index.ts`.
* Run the script with `bun run start`.

The script is using Anthropic as its LLM agent. If you want to use a different LLM, update the `model` property when calling `createDreams` in `index.ts`.

The way to interact with the agent is currently only via the CLI. The agent can perform the following actions on Paradex:

* Get account information.
* Open an order.
* Cancel an order.
* List all open orders.
* List all available markets.
* Fetch a list of all open positions.
