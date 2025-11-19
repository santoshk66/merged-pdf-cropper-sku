import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAehmBh4f0MJ-rDiXFHOZVtd65Gisj0UkI",
  authDomain: "studio-1943959795-e9b8f.firebaseapp.com",
  projectId: "studio-1943959795-e9b8f",
  storageBucket: "studio-1943959795-e9b8f.appspot.com",
  messagingSenderId: "13810809674",
  appId: "1:13810809674:web:8fc9fd4a6de82402fedfb3"
};

// Initialize Firebase
// We check if the app is already initialized to avoid errors.
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

const db = getFirestore(app);

export { db };
