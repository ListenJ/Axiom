// Command agentd runs the multi-agent task scheduling daemon: versioned
// task definitions, least-loaded scheduling with EMA prediction, tiered
// failure recovery, autoscaling, and Prometheus metrics over HTTP.
//
// Multi-node mode is enabled by AGENTD_NODES (a JSON array of
// {"id","addr","role"} objects listing every node, including this one) and
// AGENTD_NODE_ID (this node's ID within that list, default "node-1").
// With nodes configured, agentd registers remote agent proxies for its
// healthy peers, tracks node health via heartbeats, and fails the primary
// node's agents over to the local standby when the primary is lost.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"runtime-go/internal/agent"
	"runtime-go/internal/distrib"
)

func main() {
	addr := os.Getenv("AGENTD_ADDR")
	if addr == "" {
		addr = ":9102"
	}
	nodeID := os.Getenv("AGENTD_NODE_ID")
	if nodeID == "" {
		nodeID = "node-1"
	}

	cfg := agent.ClusterConfig{
		NodeID:        nodeID,
		InitialAgents: 3,
		AgentQuota: agent.ResourceQuota{
			MemoryBytes: 512 << 20,
			CPUCores:    2,
		},
		Autoscale: agent.AutoscalerConfig{
			MinAgents:            1,
			MaxAgents:            16,
			Cooldown:             30 * time.Second,
			QueuePerAgent:        4,
			ScaleUpUtilization:   0.85,
			ScaleDownUtilization: 0.15,
		},
	}
	if raw := os.Getenv("AGENTD_NODES"); raw != "" {
		nodes, err := distrib.ParseNodes(raw)
		if err != nil {
			log.Fatalf("agentd: parse AGENTD_NODES: %v", err)
		}
		cfg.Nodes = nodes
		cfg.SelfID = nodeID
		cfg.AgentsPerNode = cfg.InitialAgents
	}

	cluster, err := agent.NewCluster(cfg)
	if err != nil {
		// cgroup v2 needs write permission on /sys/fs/cgroup; unprivileged
		// deployments fall back to accounting-only isolation.
		log.Printf("agentd: platform limiter unavailable (%v), falling back to accounting limiter", err)
		cfg.Limiter = agent.NewAccountingLimiter()
		cluster, err = agent.NewCluster(cfg)
		if err != nil {
			log.Fatalf("agentd: build cluster: %v", err)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go cluster.Health.Start(ctx, 5*time.Second)

	if reg := cluster.Registry(); reg != nil {
		added, err := cluster.AddRemoteAgents()
		if err != nil {
			log.Fatalf("agentd: register remote agents: %v", err)
		}
		log.Printf("agentd: node %s, %d remote agents registered", nodeID, added)
		reg.StartHeartbeat(ctx, 5*time.Second, 2*time.Second)
		defer reg.Stop()
		go cluster.StartNodeWatch(ctx, 2*time.Second)
		if cluster.Failover != nil {
			go cluster.Failover.Start(ctx, 2*time.Second)
		}
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           agent.NewHandler(cluster),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("agentd: listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("agentd: serve: %v", err)
	}
}
