# Claude Code Agent adapter

This alpha runs Claude Code print-mode sessions through the Host Agent Adapter v1
contract. The Host grants version detection, a private identity file and a
scoped native process. Prompts travel through stdin. The adapter projects native
session IDs, assistant text, terminal outcomes and reported usage.

The current carrier runs with tools and MCP disabled. The SDK, interactive
carriers, account login, model discovery and quota have separate product
acceptance requirements.
