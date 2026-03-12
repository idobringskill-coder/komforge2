FROM node:20
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "server.js"]
