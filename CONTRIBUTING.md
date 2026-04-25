# Contributing to DS Enhance

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites
- Node.js 18+ (for testing userscripts)
- Python 3.10+ (for MCP server)
- Tampermonkey browser extension

### Local Development

1. Clone the repository:
```bash
git clone https://github.com/your-repo/ds-enhance.git
cd ds-enhance
```

2. For MCP server development:
```bash
cd server
pip install -r requirements.txt
pip install -r requirements.txt --target=.  # for dev dependencies
python server.py
```

3. For userscript development:
   - Open Tampermonkey dashboard
   - Create new script
   - Paste the content of `ds-enhance.user.js` or `ds-mcp-bridge.user.js`
   - Save and test on chat.deepseek.com

### Running Tests

```bash
cd server
pytest tests/ -v
```

### Type Checking

```bash
cd server
mypy tools/ server.py --ignore-missing-imports
```

## Code Style

### JavaScript (Userscripts)
- Use `const` and `let` instead of `var`
- Use arrow functions for callbacks
- Keep functions small and focused
- Add comments for complex logic

### Python (Server)
- Follow PEP 8 style guide
- Use type hints for all functions
- Write docstrings for public functions
- Keep line length under 120 characters

## Commit Messages

- Use clear, descriptive commit messages
- Start with a verb: Add, Fix, Update, Refactor, etc.
- Reference issues when applicable: "Fix #123"

## Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests and lint checks
5. Commit your changes
6. Push to your fork
7. Open a Pull Request

### PR Checklist
- [ ] Code follows style guidelines
- [ ] Tests pass
- [ ] Documentation updated if needed
- [ ] Commit messages are clear

## Security

If you discover a security vulnerability, please do NOT open a public issue. Instead, email the maintainers directly.

## License

By contributing, you agree that your contributions will be licensed under the GPL-3.0 License.
