fetch('http://localhost:8000/api/auth/register', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Origin': 'http://localhost:5173'
    },
    body: JSON.stringify({
        fullName: "Api Test",
        email: "apitest@example.com",
        password: "password123",
        riskAppetite: "moderate",
        virtualCapital: 1000000
    })
}).then(async res => {
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Body:", text);
}).catch(e => console.error(e));
