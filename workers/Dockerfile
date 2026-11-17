FROM golang:1.26.5 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go dashboard.html dashboard.js dashboard.css settings.js ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /scf-tunnel .
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /scf-tunnel /scf-tunnel
ENV PORT=9000
EXPOSE 9000
ENTRYPOINT ["/scf-tunnel", "-node"]
