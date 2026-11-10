FROM golang:1.26-alpine AS build
ARG FRP_VERSION=0.72.0
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "v${FRP_VERSION}" https://github.com/fatedier/frp /src
WORKDIR /src
RUN sed -i 's|FrpWebsocketPath = "/~!frp"|FrpWebsocketPath = "/frpws"|' pkg/util/net/websocket.go \
 && grep -q 'FrpWebsocketPath = "/frpws"' pkg/util/net/websocket.go
RUN CGO_ENABLED=0 go build -tags noweb -trimpath -ldflags "-s -w" -o /out/frps ./cmd/frps

FROM alpine:3.20
COPY --from=build /out/frps /usr/local/bin/frps
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
