// Command agentd runs the multi-agent task scheduling daemon: versioned
// task definitions, least-loaded scheduling with EMA prediction, tiered
// failure recovery, autoscaling, and Prometheus metrics over HTTP.
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
)

func main() {
	addr := os.Getenv("AGENTD_ADDR")
	if addr == "" {
		addr = ":9102"
	}

	cluster, err := agent.NewCluster(agent.ClusterConfig{
		NodeID:        "node-1",
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
	})
	if err != nil {
		log.Fatalf("agentd: build cluster: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go cluster.Health.Start(ctx, 5*time.Second)

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
