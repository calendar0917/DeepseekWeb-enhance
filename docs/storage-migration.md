# Storage And Migration Notes

The project keeps existing browser storage keys stable. New releases should add keys without renaming old keys unless a migration is explicitly documented and tested.

## DS Enhance

`localStorage` keys:

- `userToken`: DeepSeek bearer token read from the page. The script does not write this key.
- `dse_categories`: category list and session-to-category mapping.
- `dse_custom_prompt`: legacy single prompt key. Kept as a read fallback.
- `dse_prompts`: prompt library array. If missing, the script migrates `dse_custom_prompt` into this key.
- `dse_clipboard_cache`: last copied or pasted text used by `{clipboard}` prompt templates.

Migration behavior:

- Existing category data remains in `dse_categories`.
- Existing single-prompt users keep their prompt because `loadPrompts()` reads `dse_custom_prompt` and writes a default enabled entry into `dse_prompts`.
- Prompt template variables add behavior without changing the saved prompt schema.

## DS MCP Bridge

Tampermonkey `GM_*` keys:

- `mcp_url`: local MCP endpoint. Default remains `http://localhost:8024/mcp`.
- `mod_mcp`, `mod_tts`, `mod_ttsAutoPlay`: module toggles.
- `auto_send`: whether tool results are submitted automatically.
- `confirm_execute_command`: whether `execute_command` asks for confirmation.
- `tool_whitelist`, `tool_blacklist`: tool policy lists.
- `tts_provider`, `tts_voice`, `tts_api_key`, `tts_base_url`, `tts_model`: TTS settings.
- `tts_session_autoplay_<conversation_id>`: per-conversation autoplay override.

Migration behavior:

- Existing module, MCP URL, and TTS keys are read unchanged.
- New safety and session autoplay keys default to conservative values when absent.
- Per-session autoplay keys are additive and do not change global autoplay behavior.

## Release Rule

Any future storage rename must include:

- a compatibility read path for the old key,
- a one-time migration or documented fallback,
- a regression test that proves existing data still loads,
- a `CHANGELOG.md` note if user-visible behavior changes.
