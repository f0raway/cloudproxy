package main

import (
	"flag"
	"fmt"
	"log"
	"runtime/debug"
)

var version = "dev"

func buildVersion() string {
	if version != "dev" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" && len(s.Value) >= 12 {
				return "dev-" + s.Value[:12]
			}
		}
	}
	return version
}
func main() {
	node := flag.Bool("node", false, "run a compatible WebSocket/TCP node")
	config := flag.String("config", "/etc/scf-tunnel-proxy/agent.json", "agent config")
	check := flag.Bool("check", false, "validate effective configuration without contacting upstreams or writing data")
	showVersion := flag.Bool("version", false, "show cloudproxy build version")
	flag.Parse()
	if *showVersion {
		fmt.Println("cloudproxy", buildVersion())
		return
	}
	var err error
	if *check {
		_, err = loadAgentConfig(*config)
		if err == nil {
			fmt.Println("Configuration valid. No upstream connections or data changes were made.")
		}
	} else if *node {
		err = runNode()
	} else {
		err = runAgent(*config)
	}
	if err != nil {
		log.Fatal(err)
	}
}
