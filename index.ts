// Main entry point for K8s resources on the K3S cluster
// This file imports all resource definitions

// Infrastructure
import "./metallb";           // LoadBalancer implementation
import "./traefik";           // Internal Traefik configuration
import "./cert-manager";      // TLS certificate management with Let's Encrypt
import "./reflector"

// Databases
import "./postgresql";        // Shared PostgreSQL with CloudNativePG (operator only)
import "./redis";             // Shared Redis for caching and sessions
import "./mongodb";           // Shared MongoDB for document storage

// Applications
import "./authentik";          // Identity Provider and SSO
import "./authentik-outpost";  // Authentik Forward Auth Outpost
import "./paperless";          // Document Management System
import "./homepage";           // Homepage Dashboard
import "./unifi";              // UniFi Network Controller
import "./adguard";            // AdGuard Home DNS Ad Blocker
import "./homeassistant";      // Home Assistant home automation platform

// Monitoring
import "./monitoring";         // Prometheus, Grafana, Loki, Tempo

// Backup services
import "./timemachine";  // Time Machine backup service for macOS
