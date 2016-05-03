import hogan from "hogan.js"

export default hogan.compile(`
server {
    listen 80 default_server;
    listen 443 ssl default_server;

    server_name _;

    ssl_certificate /certs/default.crt;
    ssl_certificate_key /certs/default.crt;

    location / {
      return 404;
    }

    location /health {
      add_header Content-Type text/html;
      return 200 "healthy";
    }
}

{{#configs}}
# {{host}}
  upstream {{upstreamName}} {
    {{#upstream}}
      server {{.}};
      ip_hash; # send the same IP always to the same backend server
    {{/upstream}}
  }

  server {
    listen 80;

    server_name {{host}};

    location / {
      proxy_pass http://{{upstreamName}};
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
    }
  }

  {{#ssl}}
  server {
    listen 443 ssl;
    server_name {{host}};

    ssl_certificate /certs/{{host}}.crt;
    ssl_certificate_key /certs/{{host}}.crt;

    ssl_session_cache shared:SSL:20m;
    ssl_session_timeout 10m;

    ssl_prefer_server_ciphers       on;
    ssl_protocols                   TLSv1 TLSv1.1 TLSv1.2;
    ssl_ciphers                     ECDH+AESGCM:DH+AESGCM:ECDH+AES256:DH+AES256:ECDH+AES128:DH+AES:ECDH+3DES:DH+3DES:RSA+AESGCM:RSA+AES:RSA+3DES:!aNULL:!MD5:!DSS;

    add_header Strict-Transport-Security "max-age=31536000";

    location / {
      proxy_pass http://{{upstreamName}};
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
    }
  }
  {{/ssl}}
{{/configs}}
`)
