FROM golang:1.26-trixie AS build
WORKDIR /src
COPY go.mod *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /openjtalk-server .

FROM debian:13.7-slim
# The voice data is only packaged in contrib.
RUN sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/*.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      open-jtalk open-jtalk-mecab-naist-jdic hts-voice-nitech-jp-atr503-m001 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /openjtalk-server /usr/local/bin/openjtalk-server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/openjtalk-server"]
