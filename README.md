# Paradex-Daydreams

A proof-of-concept trading agent that connects [Daydreams](https://www.dreams.fun/) with [Paradex](https://www.paradex.trade/), allowing for AI-assisted trading operations.

## Prerequisites

- [Bun](https://bun.sh/) installed on your system
- A Paradex account with API access
- A [Groq](https://groq.com/) API key

## Installation

1. Clone the repository:

```bash
git clone https://github.com/username/Paradex-Daydreams.git
cd Paradex-Daydreams
```

2. Install dependencies:

```bash
bun install
```

3. Set up the environment variables:

```bash
cp .env.example .env
```

4. Configure your `.env` file with the following variables:

```bash
PARADEX_ACCOUNT_ADDRESS=your_paradex_account_address
PARADEX_PRIVATE_KEY=your_paradex_private_key
PARADEX_BASE_URL=your_paradex_base_url
PARADEX_CHAIN_ID=your_chain_id
GROQ_API_KEY=your_groq_api_key
```

## Usage

1. Start the agent:

```bash
bun run start
```

### Available Commands

The agent supports the following trading operations on Paradex:

1. **Get Account Information**

```bash
paradex-get-account-info
```

2. **Open a New Order**

```bash
paradex-open-order <market> <side> <type> <size> <price>
```

Example:

```bash
paradex-open-order BTC-USD-PERP BUY LIMIT 0.1 50000
```

3. **Cancel an Order**

```bash
paradex-cancel-order <order_id>
```

4. **List Open Orders**

```bash
paradex-list-open-orders
```

5. **List Available Markets**

```bash
paradex-list-available-markets
```

6. **Get Open Positions**

```bash
paradex-get-positions
```


## Configuration

- The agent uses Groq's LLaMA 3 8B model for processing commands
- JWT tokens are automatically refreshed every 3 minutes
- By default, the agent connects to Paradex testnet. For mainnet usage, update the `paradexLogin` function in `index.ts`

## Security Notes

- Never commit your `.env` file
- Keep your private keys secure
- Test thoroughly on testnet before using on mainnet

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

# Inspiration

https://github.com/milancermak/paradreams