FROM node:20
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv
RUN python3 -m venv /opt/venv
WORKDIR /app
COPY requirements.txt .
RUN /opt/venv/bin/pip install -r requirements.txt
COPY package*.json ./
RUN npm install
COPY . .
ENV PATH=/opt/venv/bin:
CMD ["node", "server.js"]
