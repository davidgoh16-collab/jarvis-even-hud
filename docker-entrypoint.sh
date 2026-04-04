#!/bin/sh
cat <<EOF > /usr/share/nginx/html/config.json
{
  "GEMINI_API_KEY": "${GEMINI_API_KEY}"
}
EOF
