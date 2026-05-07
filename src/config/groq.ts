import Groq from 'groq-sdk';
import env from './env';

const groqClient = new Groq({ apiKey: env.groqApiKey });

export default groqClient;
