#!/bin/sh
# Fetch only the key assigned to the selected Paseo provider.
case "$PASEO_INFISICAL_API_SECRET" in
    ANTHROPIC_API_KEY_*) backend=claude ;;
    GPT_API_KEY_*) backend=codex ;;
    *) echo 'Paseo API: Infisical 키 이름이 지정되지 않았습니다.' >&2; exit 1 ;;
esac

unset INFISICAL_TOKEN
if ! api_key=$(
    cd / &&
    "$PASEO_INFISICAL_CLI" secrets get "$PASEO_INFISICAL_API_SECRET" \
        --profile "$PASEO_INFISICAL_PROFILE" --domain https://app.infisical.com/api \
        --projectId 7cc30bec-94ce-45b0-b1c7-e1613de839fd --env prod --path /ai \
        --plain --silent --expand=false 2>/dev/null
); then
    echo 'Paseo API: Infisical 키 조회 실패. 로그인 상태와 키 접근 권한을 확인하세요.' >&2
    exit 1
fi
case "$api_key" in
    *[[:space:]]*) echo 'Paseo API: 키 형식이 올바르지 않습니다.' >&2; exit 1 ;;
    sk-?*) ;;
    *) echo 'Paseo API: 키 형식이 올바르지 않습니다.' >&2; exit 1 ;;
esac
unset PASEO_INFISICAL_API_SECRET PASEO_INFISICAL_PROFILE PASEO_INFISICAL_CLI

case "$backend" in
    claude)
        unset ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
        unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
        ANTHROPIC_API_KEY="$api_key" ANTHROPIC_BASE_URL=https://api.anthropic.com \
            exec "$PASEO_API_BACKEND" "$@"
        ;;
    codex)
        PASEO_OPENAI_INFERENCE_KEY="$api_key" exec "$PASEO_API_BACKEND" \
            -c 'model_provider="paseo_direct_openai"' \
            -c 'model_providers.paseo_direct_openai.name="OpenAI API"' \
            -c 'model_providers.paseo_direct_openai.base_url="https://api.openai.com/v1"' \
            -c 'model_providers.paseo_direct_openai.env_key="PASEO_OPENAI_INFERENCE_KEY"' \
            -c 'model_providers.paseo_direct_openai.wire_api="responses"' \
            -c 'model_providers.paseo_direct_openai.requires_openai_auth=false' \
            "$@"
        ;;
esac
