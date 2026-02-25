// Main entry point for K8s resources on the K3S cluster
// This file imports all resource definitions

import "./infrastructure";  // MetalLB, Traefik, cert-manager, Reflector
import "./databases";       // PostgreSQL, Redis, MongoDB
import "./auth";            // Authentik, Authentik Outpost
import "./apps";            // Paperless, Homepage, UniFi, AdGuard, Home Assistant, Time Machine
import "./monitoring";      // Prometheus, Grafana, Loki, Tempo
