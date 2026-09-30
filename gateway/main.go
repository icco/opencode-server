package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"
	_ "github.com/caddyserver/caddy/v2/modules/standard"
	_ "go.icco.me/opencode-server/gateway/guard"
)

func main() { caddycmd.Main() }
