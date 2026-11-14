package web

import "embed"

// Files contains the production frontend output.
//
//go:embed all:dist
var Files embed.FS
